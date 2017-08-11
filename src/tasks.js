const AWSXRay = require('aws-xray-sdk')
const Client = require('pg').Client
const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const unfluff = require('unfluff')
const kinesis = require('@heroku/kinesis')
const uuid = require('uuid/v4');
const chrono = require('chrono-node')
const _ = require('lodash')
const Promise = require("bluebird")
const redis = Promise.promisifyAll(require("redis"));
const createThrottle = require('async-throttle')
 
import moment from 'moment'
import { trigger } from './events'

async function log(name, message) {
  console.log(name + " - " + message)
  const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost'
  })
  await redisClient.lpushAsync("pressminder:log:" + name, moment().format('lll') + ": " + message)
  await redisClient.quitAsync()
}

function startSegment(name, args) {
  return new Promise((resolve, reject) => {
    if (process.env.NODE_ENV !== 'production') {
      resolve()
      return
    }

    args = args || {}
    AWSXRay.captureAsyncFunc(name, function(subsegment) {
      for (let key of Object.keys(args)) {
        subsegment.addAnnotation(key, args[key]);
      }
      resolve(subsegment)
    });
  })
}

function endSegment(segment) {
  if (segment) {
    segment.close()
  }
}

export async function scanPage(data) {
  const segment = await startSegment('scan', {url: data.url})
  const htmlString = await request(data.url)
  const $ = cheerio.load(htmlString)
  let urls = []
  $('a').each((i, elem) => {
    let url = $(elem).attr('href');
    if (url && url.match(new RegExp(data.linkRegex, 'i'))) {
      if (url.indexOf('http') === -1) {
        url = data.url + url 
      }
      url = url.split('#')[0]
      urls.push(url)
    }
  })
  console.log("Finished scanning " + data.url + ", found " + urls.length + " links")

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
      let link = row.link
      log(link, "Found on " + data.url)
      await trigger('url', {
        url: link,
        page: data.url
      })
    }
  } catch (err) {
    endSegment(segment)
    console.error(err)
  } finally {
    endSegment(segment)
    await client.end()
  }
}

export async function retrieveArticle(input) {
  if (!input.url) {
    console.log("No url provided to retrieve article!")
    return
  }
  
  const segment = await startSegment('url', {url: input.url})
  try {
    log(input.url, "Requesting desktop site")
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

    const output = {
      authors,
      keywords: (lazy.keywords() || "").split(',').filter(k => k.length),
      title: lazy.title(),
      url: lazy.canonicalLink(),
      published: chrono.parseDate(lazy.date()),
      links: lazy.links().map(l => l.href).filter(x => x.indexOf('.') != -1),
      _placementUrl: input.url,
      _placementPage: input.page
    }

    log(input.url, "Parsed desktop site: " + JSON.stringify(output))

    if (!output.title) {
      log(input.url, "Invalid, no title found.")
      return
    } else if (!output.url) {
      log(input.url, "Invalid, no canonical url found.")
      return
    }
      
    log(output.url, "Requesting mobile site")

    try {
      const lazyMobile = unfluff.lazy(await request({
        uri: output.url,
        headers: {
          "User-Agent": "mozilla/5.0 (iphone; cpu iphone os 7_0_2 like mac os x) applewebkit/537.51.1 (khtml, like gecko) version/7.0 mobile/11a501 safari/9537.53",
          referer: "https://www.google.com/"
        }
      }))
      output.text = lazyMobile.text()
      output.image = lazyMobile.image()
      output.tags = lazyMobile.tags()

      log(output.url, "Parsed mobile site: " + JSON.stringify(output))
    } catch (err) {
      log(output.url, "Failed to retrieve mobile site: " + err)
    }
    
    await trigger('article', output)
    endSegment(segment)
  } catch (err) {
    log(input.url, "Failed to retrieve article: " + err)
    console.error(err)
    endSegment(segment)
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

async function checkSocial(url, client) {
  const htmlString = await request({
    uri: "https://twitter.com/search?f=tweets&q=" + encodeURIComponent(url) + "&src=typd",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36"
    }
  })
  const $ = cheerio.load(htmlString)
  const tweetTimestamps = $('.tweet-timestamp .js-short-timestamp').map((i, el) => parseInt($(el).attr('data-time'))).get()
  const earliest = new Date(tweetTimestamps[tweetTimestamps.length - 1] * 1000)
  log(url, "Found " + tweetTimestamps.length + " tweets, earliest " + earliest.toLocaleString())
  await client.query("INSERT INTO social (url, timestamp, tweets, earliest_tweet) VALUES ($1, now(), $2, $3)",
                      [url, tweetTimestamps.length, earliest])
}

export async function checkArticles() {
  
  const client = new Client()
  await client.connect()

  const segment = await startSegment('check')
  try {

    let res = await client.query("SELECT url FROM article \
                                  WHERE (last_checked < now() - interval '1 hour' \
                                  AND first_checked > now() - interval '1 day') OR \
                                    (last_checked < now() - interval '1 day' \
                                  AND first_checked > now() - interval '1 week') OR \
                                    (last_checked < now() - interval '1 week')")

    for (const row of res.rows) {
      log(row.url, "Stale article, requesting update")
      await trigger('url', {
        url: row.url
      })
    }

    res = await client.query("SELECT article.url, social.url as s FROM article \
                              LEFT JOIN social \
                              ON social.url = article.url AND social.timestamp > now() - interval '1 day' \
                              WHERE social.url IS NULL AND article.first_checked > now() - interval '7 day'")
    

    const throttle = createThrottle(1)
    for (const row of res.rows) {
      log(row.url, "Stale social, requesting update")
      await checkSocial(row.url, client)
    }
  }
  catch (err) {
    endSegment(segment)
    console.error(err)
  } finally {
    endSegment(segment)
    await client.end()
  }
}

export async function processArticles(articles) {
  const client = new Client()
  await client.connect()

  try {
    for (let article of articles) {
      const segment = await startSegment('article', {url: article.url})
      const res = await client.query('INSERT INTO article (url, last_checked, first_checked) \
                VALUES ($1, now(), now()) \
                ON CONFLICT (url) DO UPDATE SET last_checked=now()', 
                [article.url])

      log(article.url, "Updated articles db")

      if (article._placementPage && article._placementUrl) {
        const updateResult = await client.query('UPDATE placement SET url = $1 \
                            WHERE link = $2 AND page = $3', 
                            [article.url, article._placementUrl, article._placementPage])
        if (updateResult.rowCount) {
          log(article.url, "Saved as canonical link of " + article._placementUrl)
          log(article._placementUrl, "Set canonical link to " + article.url)
        } else {
          log(article.url, "Failed to save as canonical link of " + article._placementUrl + " on " + article._placementPage)
          log(article._placementUrl, "Failed to set canonical link to " + article.url + " (" + article._placementPage + ")")
        }
      }

      if (article.text) {
        const versions = await getVersions(article.url, client)
        if (!versions.length || versions.slice(-1)[0].text != article.text) {
          await client.query('INSERT INTO version (url, text, title, links, authors, keywords, published) \
                          VALUES ($1, $2, $3, $4, $5, $6, $7)', 
                          [article.url, article.text, article.title, article.links, 
                            article.authors, article.keywords, article.published])
          log(article.url, "Saved new version")
        }
      }
      endSegment(segment)
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
}
