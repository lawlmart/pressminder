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
const S3 = require('aws-sdk/clients/s3');
const retextKeywords = require('retext-keywords');
const retext = require('retext');
const nlcstToString = require('nlcst-to-string');
 
import moment from 'moment'
import { trigger } from './events'

async function log(name, message) {
  console.log(name + " - " + message)
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

const getArticles = async function(count, offset, name, platform, timestamp) {
  const scans = []
  const client = new Client()
  await client.connect()
  try {
    let vars = []
    let query = "SELECT MIN(placement.started) as first_seen, scan.screenshot, scan.platform, placement.scan_name, \
    placement.top, placement.url, version.title, version.timestamp, version.keywords, \
    version.generated_keywords FROM placement, version, scan, (SELECT url, max(timestamp) as timestamp \
    FROM version GROUP BY url) v, \
    (SELECT placement.url, placement.scan_name, min(placement.top) as top FROM placement "
    if (timestamp) {
      query += "WHERE EXTRACT(epoch FROM COALESCE(placement.ended, now())) >= $" + (vars.length + 1).toString() 
      vars.push(timestamp)
      query += " AND EXTRACT(epoch FROM placement.started) <= $" + (vars.length + 1).toString()
      vars.push(timestamp)
    } else {
      query += "WHERE placement.ended IS NULL"
    }
    query += " GROUP BY placement.url, placement.scan_name) t \
    WHERE t.top = placement.top AND t.url = placement.url AND t.scan_name = placement.scan_name \
    AND v.url = placement.url AND version.timestamp = v.timestamp AND scan.id = placement.scan_id"
    if (name) {
      query += " AND placement.scan_name = $" + (vars.length + 1).toString()
      vars.push(name)
    } 
    if (platform) {
      query += " AND scan.platform = $"  + (vars.length + 1).toString()
      vars.push(platform)
    } 
    query += " GROUP BY placement.scan_name, scan.screenshot, scan.platform, placement.top, placement.url, version.title, version.timestamp, \
    version.keywords, version.generated_keywords ORDER BY scan_name, top ASC"
    if (count) {
      query += " LIMIT $" + (vars.length + 1).toString()
      vars.push(count)
    }
    if (offset) {
      query += " OFFSET $" + (vars.length + 1).toString()
      vars.push(offset)
    }
    const res = await client.query(query, vars)
    let lastScanName = null

    let articles = []
    for (const row of res.rows) {
      if (lastScanName != row.scan_name) {
        scans.push({
          articles: articles,
          scanName: scan_name
        })
        articles = []          
      }
      articles.push({
        url: row.url,
        since: row.first_seen,
        title: row.title
      })
    }
  }
  catch (err) {
    console.log("Error getArticles: " + err + " " + err.stack)
  } finally {
    await client.end()
  }
  return scans
}

export async function finishedScan(data) {
  const segment = await startSegment('placements', {url: data.url})

  const client = new Client()
  await client.connect()
  try {
    
    let res = await client.query('INSERT INTO scan (url, screenshot, timestamp, platform, name, publication_id) \
                        VALUES ($1, $2, now(), $3, $4, $5) RETURNING id', 
                        [data.url, data.screenshot, data.platform, data.name, data.publicationId])
    const scanId = res.rows[0].id     

    await client.query('BEGIN')
    try {
      await client.query('UPDATE placement SET ended = now(), new = FALSE \
                          WHERE ended IS NULL \
                          AND scan_name = $1', [data.name])

      for (const placement of data.placements) {
        await client.query('INSERT INTO placement (link, started, new, title, top, "left", \
                            height, width, font_size, section, scan_id, scan_name) \
                            VALUES ($1, now(), TRUE, $2,  $3, $4, $5, $6, $7, $8, $9, $10) \
                            ON CONFLICT (scan_name, link, title, top, font_size, width) DO UPDATE SET ended = NULL', 
                            [placement.url.substring(0,500), placement.title.substring(0,500), placement.top, placement.left, 
                              placement.height, placement.width, placement.fontSize, 
                              placement.section, scanId, data.name])
      }
      await client.query('COMMIT')
    } catch (err) {
      console.log("ROLLING BACK Error: " + err)
      await client.query('ROLLBACK')
    }

    res = await client.query('SELECT link FROM placement \
                              WHERE new = TRUE AND ended IS NULL AND scan_name = $1', [data.name])
    for (const row of res.rows) {

      let link = row.link
      log(link, "Found on " + data.url)
      await trigger('url', {
        url: link,
        name: data.name
      })
    }
  } catch (err) {
    await client.query('ROLLBACK')
    endSegment(segment)
    console.log("Error: " + err)
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
      _placementUrl: input.url
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
    uri: "https://twitter.com/search?q=" + encodeURIComponent(url) + "&src=typd",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36"
    }
  })
  const $ = cheerio.load(htmlString)
  const tweetTimestamps = $('.tweet-timestamp .js-short-timestamp').map((i, el) => parseInt($(el).attr('data-time'))).get()
  let earliest = null
  if (tweetTimestamps.length) {
    earliest = new Date(tweetTimestamps[tweetTimestamps.length - 1] * 1000)
  }
  log(url, "Found " + tweetTimestamps.length + " tweets, earliest " + (earliest ? earliest.toLocaleString() : 'none'))
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
    
  }
  catch (err) {
    endSegment(segment)
    console.error(err)
  } finally {
    endSegment(segment)
    await client.end()
  }
}

async function processKeywords(text) {
  return new Promise((resolve, reject) => {
    retext()
    .use(retextKeywords)
    .process(text, function (err, file) {
      const keywords = new Set()
      file.data.keyphrases.forEach(function (phrase) {
        keywords.add(phrase.matches[0].nodes.map(nlcstToString).join(''))
      });
      file.data.keywords.forEach(function (keyword) {
        keywords.add(nlcstToString(keyword.matches[0].node))
      });
      resolve(Array.from(keywords))
    });
  })
}

export async function snapshot() {
  const client = new Client()
  await client.connect()

  try {
    const segment = await startSegment('snapshot')
    const articles = await getArticles()
    await client.query('INSERT INTO snapshot (timestamp, content) VALUES (now(), $1)', [articles])
    endSegment(segment)
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
      const segment = await startSegment('article', {url: article.url})
      const res = await client.query('INSERT INTO article (url, last_checked, first_checked) \
                VALUES ($1, now(), now()) \
                ON CONFLICT (url) DO UPDATE SET last_checked=now()', 
                [article.url])

      log(article.url, "Updated articles db")

      if (article._placementUrl) {
        const updateResult = await client.query('UPDATE placement SET url = $1 \
                            WHERE link = $2', 
                            [article.url, article._placementUrl])
        if (updateResult.rowCount) {
          log(article.url, "Saved as canonical link of " + article._placementUrl)
          log(article._placementUrl, "Set canonical link to " + article.url)
        } else {
          log(article.url, "Failed to save as canonical link of " + article._placementUrl)
          log(article._placementUrl, "Failed to set canonical link to " + article.url)
        }
      }

      if (article.text) {
        const versions = await getVersions(article.url, client)
        if (!versions.length || versions.slice(-1)[0].text != article.text) {
          const generatedKeywords = await processKeywords(article.text)
          console.log(generatedKeywords)
          await client.query('INSERT INTO version (url, text, title, links, authors, keywords, published, generated_keywords) \
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', 
                          [article.url, article.text, article.title, article.links, 
                            article.authors, article.keywords, article.published, generatedKeywords])
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
