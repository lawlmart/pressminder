const Promise = require("bluebird");
const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const unfluff = require('unfluff')
const S3 = require('aws-sdk/clients/s3');
const { Client, Pool } = require('pg')
const kinesis = require('@heroku/kinesis')
const uuid = require('uuid/v4');
const chrono = require('chrono-node')
const _ = require('lodash')
const redis = Promise.promisifyAll(require("redis"));
import { trigger } from './events'

const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || 'localhost'
})

export async function scanPage(data) {
  const scanId = uuid()
  data.id = scanId
  console.log(scanId + ": Processing page " + JSON.stringify(data))

  const htmlString = await request(data.url)
  const $ = cheerio.load(htmlString)
  let urls = []
  $('a').each((i, elem) => {
    const url = $(elem).attr('href');
    if (url && url.match(new RegExp(data.linkRegex, 'i'))) {
      urls.push({
        _scanId: scanId,
        _scanUrl: data.url, 
        url: url
      })
    }
  })

  console.log(scanId + ": Found " + urls.length.toString() + " urls on page " + data.url)
  const redisKey = "pressminder:scan:" + scanId
  await redisClient.setAsync(redisKey, JSON.stringify({
    timestamp: Math.round(Date.now() / 1000)
  }))
  await redisClient.setAsync(redisKey + ":urls", urls.length)

  for (let url of urls) {
    await trigger('url', url)
  }
  return urls
}

export async function retrieveArticle(input) {
  try {
    const redisKey = "pressminder:scan:" + input._scanId
    await redisClient.incrAsync(redisKey + ":retrieved")

    console.log("Requesting " + input.url)
    const lazy = unfluff.lazy(await request({
      uri: input.url,
      headers: {
        referer: "https://www.google.com/"
      }
    }))

    const author =  _(lazy.author())
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
      author,
      keywords,
      title: lazy.title(),
      canonicalLink: lazy.canonicalLink(),
      published: chrono.parseDate(lazy.date()),
      links: lazy.links().map(l => l.href),
      _scanId: input._scanId,
      _scanUrl: input._scanUrl,
      _foundUrl: input.url
    }
    console.log(output)
    console.log("Requesting mobile " + input.url)
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
    
    console.log("Retrieved article " + output.title + " by " + output.author + "  (" + output.text.length + ") chars")

    await redisClient.incrAsync(redisKey + ":found")
    await trigger('article', output)

    return output
  } catch (err) {
    console.log("Failed to retrieve article " + input.url + ": " + err)
  }
}

async function saveVersion(article, db) {
  const res = await db.query('SELECT text FROM version WHERE article_id = $1 ORDER BY timestamp DESC LIMIT 1', [article.id])
  if (res.rows.length) {
    const text = res.rows[0].text
    if (text == article.text) {
      return
    }
  }
  console.log("Saving version of article " + article.id.toString())
  await db.query('INSERT INTO version (article_id, text) VALUES ($1, $2)', [article.id, article.text])
}

export async function scanComplete(data) {
  const { id, url, articles } = data

  console.log("Completed scan of " + url + " (" + id + ")")

  const client = new Client()
  await client.connect()

  const results = await client.query('SELECT article_id FROM placement \
                                  WHERE ended IS NULL \
                                  AND url = $1', [url])
  

  const promises = []
  const existingIds = results.rows.map(row => parseInt(row.article_id))
  const newIds = Object.keys(articles).map(key => parseInt(key))

  for (const existingId of existingIds) {
    if (newIds.indexOf(existingId) === -1) {
      console.log("Ended placement for article " + existingId.toString() + " at " + url)

      promises.push(client.query('UPDATE placement SET ended=now() \
      WHERE ended IS NULL \
      AND article_id = $1 \
      AND url = $2', [existingId, url]))
    }
  }

  for (const newId of newIds) {
    if (existingIds.indexOf(newId) === -1) {
      console.log("New placement for article " + newId.toString() + " at " + url)

      promises.push(
        client.query('INSERT INTO placement (article_id, url, started) VALUES ($1, $2, now())', [newId, url])
      )
    }
  }
  return Promise.all(promises)

  await client.end()
}

export async function processArticles(articles) {
  const client = new Client()
  await client.connect()

  for (let data of articles) {
    const res = await client.query('INSERT INTO article (url, title, author, published, keywords, links) \
              VALUES ($1, $2, $3, $4, $5, $6) \
              ON CONFLICT (url) DO UPDATE SET last_checked=now() RETURNING id', 
              [data.canonicalLink, data.title, data.author, data.published, data.keywords, data.links])
    const id = res.rows[0].id
    console.log("Article (" + id.toString() + ") " + data.canonicalLink + " saved")
    data.id = id
    if (data.text) {
      await saveVersion(data, client)
    }

    const EXPIRATION = 3600
    const redisKey = "pressminder:scan:" + data._scanId
    const results = await redisClient.multi()
    .hset(redisKey + ":articles", data.id, JSON.stringify(data))
    .incr(redisKey + ":processed")
    .get(redisKey + ":found")
    .get(redisKey + ":retrieved")
    .get(redisKey + ":urls")
    .hgetall(redisKey + ":articles")
    .expire(redisKey, EXPIRATION)
    .expire(redisKey + ":articles", EXPIRATION)
    .expire(redisKey + ":processed", EXPIRATION)
    .execAsync()

    if (results[1] == results[2] && results[3] == results[4]) {
      let articles = results[5]
      for (let key in articles) {
        articles[key] = JSON.parse(articles[key])
      }
      await trigger('scan_complete', {
        articles,
        id: data._scanId,
        url: data._scanUrl
      })
    }
  }
  await client.end()
}
