const AWSXRay = require('aws-xray-sdk')
const pg = require('pg');
const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const unfluff = require('unfluff')
const kinesis = require('@heroku/kinesis')
const uuid = require('uuid/v4');
const chrono = require('chrono-node')
const _ = require('lodash')
const Promise = require("bluebird")
const retextKeywords = require('retext-keywords');
const retext = require('retext');
const nlcstToString = require('nlcst-to-string');
 
import moment from 'moment'
import { trigger } from './events'

async function log(name, message) {
  console.log(name + " - " + message)
}

function scoreScan(scan) {
  let left = 9999999;
  let right = 0;
  let bottom = 0;
  let top = 99999999;
  for (const article of scan.articles) {
    if (article.left < left) {
      left = article.left
    }
    if (article.top < top) {
      top = article.top
    }
    if (article.left + article.width > right) {
      right = article.left + article.width
    }
    if (article.top + article.height > bottom) {
      bottom = article.top + article.height
    }
  }

  console.log(`Analyzed scan ${scan.scan_name} (top: ${top}, bottom: ${bottom}, left: ${left}, right ${right}`)

  for (const article of scan.articles) {
    const topScore = 1 - (article.top - top) / (bottom - top)
    const leftScore = 1 - (article.left - left) / (right - left)
    const sizeScore = article.height * article.width / ((bottom - top) * (right - left))
    const fontScore = article.font_size / 32
    const score = 100 * topScore + 1 * leftScore
    //console.log(`Calculated score ${score} (top: ${topScore}, leftScore: ${leftScore}, sizeScore: ${sizeScore}, fontScore: ${fontScore} for ${article.url}`)
    article.score = score
  }
}

export async function getArticles(timestamp, count, offset, name, platform) {
  const scans = []
  const client = new pg.Client()
  await client.connect()
  try {
    let vars = []
    let query = "SELECT placement.started, placement.scan_name, \
    placement.top, placement.left, placement.height, placement.width, placement.font_size, \
    placement.url, placement.title \
    FROM placement WHERE"
    if (timestamp) {
      query += " COALESCE(placement.ended, now()) >= $" + (vars.length + 1).toString() 
      vars.push(new Date(timestamp * 1000)) 
      query += " AND placement.started <= $" + (vars.length + 1).toString()
      vars.push(new Date(timestamp * 1000)) 
    } else {
      query += " placement.ended IS NULL"
    }
    if (name) {
      query += " AND placement.scan_name = $" + (vars.length + 1).toString()
      vars.push(name)
    } 
    query += " ORDER BY placement.scan_name ASC"
    if (count) {
      query += " LIMIT $" + (vars.length + 1).toString()
      vars.push(count)
    }
    if (offset) {
      query += " OFFSET $" + (vars.length + 1).toString()
      vars.push(offset)
    }
    console.log("Running " + query + " " + JSON.stringify(vars))
    const res = await client.query(query, vars)
    let currentScan = null
    for (const row of res.rows) {
      if (currentScan && currentScan.scan_name != row.scan_name) {
        scans.push(currentScan)
        currentScan = null     
      }
      if (!currentScan) {
        const scanName = row.scan_name
        let scanRes
        if (timestamp) {
          scanRes = await client.query("SELECT screenshot FROM scan WHERE \
            timestamp <= $1 AND name = $2 ORDER BY timestamp DESC LIMIT 1", 
            [new Date(timestamp * 1000), scanName])
        } else {
          scanRes = await client.query("SELECT screenshot FROM scan WHERE \
            name = $1 ORDER BY timestamp DESC LIMIT 1", [scanName])
        }
        let screenshot = scanRes.rows.length ? scanRes.rows[0].screenshot : null
        currentScan = {
          articles: [],
          scan_name: scanName,
          screenshot: screenshot
        }
      }
      const article = {
        url: row.url,
        since: row.started,
        title: row.title,
        top: row.top,
        left: row.left,
        height: row.height,
        width: row.width,
        font_size: row.font_size
      }
      currentScan.articles.push(article)
    }
    if (currentScan) {
      scans.push(currentScan)
    }

    for (const scan of scans) {
      scoreScan(scan)
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
  const client = new pg.Client()
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
                            ON CONFLICT (scan_name, link, title, top, font_size, width) DO UPDATE SET ended=NULL, scan_id=$11', 
                            [placement.url.substring(0,500), placement.title.substring(0,500), placement.top, placement.left, 
                              placement.height, placement.width, placement.fontSize, 
                              placement.section, scanId, data.name, scanId])
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
    console.log("Error: " + err)
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
    log(input.url, "Requesting desktop site")
    const rawDesktop = await request({
      uri: input.url,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
        referer: "https://www.google.com/"
      }
    })
    const lazy = unfluff.lazy(rawDesktop)
    

    let authors =  _(lazy.author())
                    .flatMap(a => a ? a.split(', ') : [])
                    .flatMap(a => a ? a.split(' and ') : [])
                    .map(a => a.trim())
                    .filter(x => x.indexOf('.com') === -1)
                    .filter(x => x.indexOf('.www') === -1)
                    .value()

    const wpAuthors = rawDesktop.match(/wp_meta_data\.author=([^;]*);/g)
    if (wpAuthors && wpAuthors.length) {
      authors = JSON.parse(wpAuthors[0].replace("wp_meta_data.author=", "").replace(";", ""))
      log(input.url, `Found WP Authors ${authors}`)
    }

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
      let rawMobile = await request({
        uri: output.url,
        headers: {
          "User-Agent": "mozilla/5.0 (iphone; cpu iphone os 7_0_2 like mac os x) applewebkit/537.51.1 (khtml, like gecko) version/7.0 mobile/11a501 safari/9537.53",
          referer: "https://www.google.com/"
        }
      })

      const $ = cheerio.load(rawMobile);
      $( ".robots-nocontent" ).remove();
      rawMobile = $.html()

      const lazyMobile = unfluff.lazy(rawMobile)
      output.text = lazyMobile.text()
      output.image = lazyMobile.image()
      output.tags = lazyMobile.tags()

      log(output.url, "Parsed mobile site: " + JSON.stringify(output))
    } catch (err) {
      log(output.url, "Failed to retrieve mobile site: " + err)
    }
    
    await trigger('article', output)
  } catch (err) {
    log(input.url, "Failed to retrieve article: " + err)
  }
}

export async function getVersions(url, client) {
  const res = await client.query("SELECT text, title, keywords, authors, url, \
                                  extract(EPOCH from timestamp) as timestamp,  \
                                  extract(EPOCH from published) as published \
                                  FROM version \
                                  WHERE url = $1 \
                                  ORDER BY timestamp DESC",
                                  [url])
  return res.rows.map(r => { return {
    text: r.text,
    title: r.title,
    keyword: r.keywords,
    authors: r.authors,
    timestamp: parseInt(r.timestamp),
    published: r.published,
    url: r.url
  }})
}

export async function checkArticles() {
  
  const client = new pg.Client()
  await client.connect()
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
    console.error(err)
  } finally {
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

export async function snapshots(input) {
  const { start, end, interval } = input
  console.log(`Creating snapshots from ${start} to ${end} at ${interval}`)

  for (let i = start; i <= end; i += interval) {
    await trigger('snapshot', {
      timestamp: i
    })
  }
}

export async function snapshot(input) {
  input = input || {}
  const timestamp = input.timestamp || null
  const client = new pg.Client()
  await client.connect()
  try {
    console.log("Getting scans on " + timestamp)
    const scans = await getArticles(timestamp)
    console.log("Snapshotting " + scans.length + " scans")
    for (let scan of scans) {
      const articles = {}
      let maxScore = 0
      for (const a of scan.articles) {
        if (a.score > maxScore) {
          maxScore = a.score
        }
      }
      let rank = 0
      scan.articles.sort((a,b) => {
        return a.score - b.score
      })
      console.log(scan.articles)
      for (const a of scan.articles) {
        a.normalized_score = a.score / maxScore
        a.rank = rank
        rank += 1
        articles[a.url] = a
      }
      let query
      if (timestamp) {
        await client.query('INSERT INTO snapshot (timestamp, scan_name, screenshot, articles_json) \
        VALUES ($1, $2, $3, $4)', 
        [new Date(timestamp * 1000), scan.scan_name, scan.screenshot, articles]) 
      } else {
        await client.query('INSERT INTO snapshot (timestamp, scan_name, screenshot, articles_json) \
        VALUES (now(), $1, $2, $3)', 
        [scan.scan_name, scan.screenshot, articles])
      }
      
    }    
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
}


export async function processArticles(articles) {
  const client = new pg.Client()
  await client.connect()

  try {
    for (let article of articles) {
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
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
}
