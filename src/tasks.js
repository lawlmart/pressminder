const Promise = require("bluebird");
const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const unfluff = require('unfluff')
const S3 = require('aws-sdk/clients/s3');
const { Client } = require('pg')
const kinesis = require('@heroku/kinesis')
const uuid = require('uuid/v4');
const chrono = require('chrono-node')
const _ = require('lodash')

import { trigger } from './events'

export async function scanPage(data) {

  const htmlString = await request(data.url)
  const $ = cheerio.load(htmlString)
  let urls = []
  $('a').each((i, elem) => {
    const url = $(elem).attr('href');
    if (url && url.match(new RegExp(data.linkRegex, 'i'))) {
      urls.push(url)
    }
  })

  const client = new Client()
  await client.connect()
  try {
    await client.query('UPDATE placement SET ended = now(), new = FALSE \
                        WHERE ended IS NULL \
                        AND page = $1', [data.url])

    for (const url of urls) {
      await client.query('INSERT INTO placement (page, link, started, new) \
                          VALUES ($1, $2, now(), TRUE) \
                          ON CONFLICT (page, link) DO UPDATE SET ended = NULL', [data.url, url])
    }

    const res = await client.query('SELECT link FROM placement \
                              WHERE new = TRUE AND ended IS NULL AND page = $1', [data.url])

    for (const row of res.rows) {
      console.log("Found new placement " + row.url)
      await trigger('url', {
        url: row.link,
        page: data.url
      })
    }
    console.log("Finished scanning " + data.url)
  } catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
}

export async function retrieveArticle(input) {
  if (!input.url) {
    console.log("No url provided to retrieve article!")
    return
  }
  try {
    console.log("Requesting " + JSON.stringify(input))
    const lazy = unfluff.lazy(await request({
      uri: input.url,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
        referer: "https://www.google.com/"
      }
    }))

    const authors =  _(lazy.author())
                    .flatMap(a => a ? a.split(', ') : [])
                    .flatMap(a => a ? a.split(' and ') : [])
                    .map(a => a.trim())
                    .filter(x => x.indexOf('.com') === -1)
                    .filter(x => x.indexOf('.www') === -1)
                    .value()

    let keywords = lazy.keywords()
    if (keywords) {
      keywords = keywords.split(',')
    }

    const output = {
      authors,
      keywords,
      title: lazy.title(),
      url: lazy.canonicalLink(),
      published: chrono.parseDate(lazy.date()),
      links: lazy.links().map(l => l.href).filter(x => x.indexOf('.') != -1),
      _placementUrl: input.url,
      _placementPage: input.page
    }

    if (!output.title || !output.published || !authors.length) {
      console.log("Invalid article found: " + JSON.stringify(output))
      return
    }

    console.log("Requesting mobile " + output.url)
    try {
      const lazyMobile = unfluff.lazy(await request({
        uri: input.url,
        headers: {
          "User-Agent": "mozilla/5.0 (iphone; cpu iphone os 7_0_2 like mac os x) applewebkit/537.51.1 (khtml, like gecko) version/7.0 mobile/11a501 safari/9537.53",
          referer: "https://www.google.com/"
        }
      }))
      output.text = lazyMobile.text()
      output.image = lazyMobile.image()
      output.tags = lazyMobile.tags()

      console.log("Retrieved article " + output.title + " by " + output.authors.join(", ") + "  (" + output.text.length + ") chars")
    } catch (err) {
      console.log("Failed to retrieve full text of article " + output.url)
    }
    
    console.log(output)
    await trigger('article', output)
  } catch (err) {
    console.log("Failed to retrieve article " + input.url + ": " + err)
    console.error(err)
  }
}

export async function getVersions(url, client) {
  const res = await client.query("SELECT text FROM version \
                                  WHERE url = $1 \
                                  ORDER BY timestamp ASC",
                                  [url])
  return res.rows.map(r => { return {
    text: r.text
  }})
}

export async function checkArticles() {
  const client = new Client()
  await client.connect()
  try {
    const res = await client.query("SELECT url FROM article \
      WHERE (last_checked < now() - interval '5 minute' AND first_checked > now() - interval '1 hour') OR \
      (last_checked < now() - interval '1 hour' AND first_checked > now() - interval '1 day') OR \
      (last_checked < now() - interval '1 day' AND first_checked > now() - interval '1 week') OR \
      (last_checked < now() - interval '1 week')")

    for (const row of res.rows) {
      console.log("Requesting update of " + row.url)
      await trigger('url', {
        url: row.url
      })
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
}

export async function processArticles(articles) {
  const client = new Client()
  await client.connect()
  try {
    for (let article of articles) {
      const res = await client.query('INSERT INTO article (url, last_checked, first_checked) \
                VALUES ($1, now(), now()) \
                ON CONFLICT (url) DO UPDATE SET last_checked=now()', 
                [article.url])
      
      console.log("Article " + article.url + " saved")

      if (article._placementPage && article._placementUrl) {
        await client.query('UPDATE placement SET url = $1 \
                            WHERE link = $2 AND page = $3', 
                            [article.url, article._placementUrl, article._placementPage])
        console.log("Placement url " + article.url + " updated")
      }

      if (article.text) {
        const versions = await getVersions(article.url, client)
        console.log("Version comparison - num versions: " + versions.length.toString() + " last version: " + 
                    (versions.length ? versions.slice(-1)[0].text : "").length + " chars,  new version: " + 
                    article.text.length + " chars")
        if (!versions.length || versions.slice(-1)[0].text != article.text) {
          console.log("Saving version " + JSON.stringify(article))
          await client.query('INSERT INTO version (url, text, title, links, authors, keywords, published) \
                          VALUES ($1, $2, $3, $4, $5, $6, $7)', 
                          [article.url, article.text, article.title, article.links, 
                            article.authors, article.keywords, article.published])
        }
      }
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
}
