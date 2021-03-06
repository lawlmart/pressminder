import ApiBuilder from 'claudia-api-builder'
import moment from 'moment'
import { getVersions, getArticles } from './tasks'
import  AWSXRay from 'aws-xray-sdk'

const Promise = require("bluebird")
const pg = require('pg');
const api = new ApiBuilder('AWS_PROXY');

const renderPage = function (body) {
  return `
    <html>
      <head>
        <title>PressMinder</title>
        <meta charset="UTF-8">
      </head>
      <body>
        ${body}
      </body>
    </html>
  `
};

const getPlacements = async function(count, offset, name, timestamp) {
  const placements = []  
  
  const client = new pg.Client()
  await client.connect()
  try {
    timestamp = timestamp || Math.round(Date.now() / 1000)
    let vars = [timestamp, timestamp, count, offset]
    let query = "SELECT placement.scan_name, \
    placement.top, placement.url, placement.title, version.timestamp, version.keywords, \
    version.generated_keywords, version.published \
    FROM placement, version, \
    (SELECT url, max(timestamp) as timestamp \
        FROM version GROUP BY url) v \
    WHERE v.url = placement.url AND version.timestamp = v.timestamp AND \
    EXTRACT(epoch FROM COALESCE(placement.ended, now())) >= $1 AND \
    EXTRACT(epoch FROM placement.started) <= $2"
    if (name) {
      query += " AND placement.scan_name = $" + (vars.length + 1).toString()
      vars.push(name)
    }
    query += " ORDER BY top ASC LIMIT $3 OFFSET $4"
    const res = await client.query(query, vars)
    for (const row of res.rows) {
      placements.push({
        url: row.url,
        since: row.published,
        name: row.scan_name,
        title: row.title,
        top: row.top
      })
    }
  }
  catch (err) {
    console.log("Error: " + err)
  } finally {
    await client.end()
  }
  return placements
}

api.get('/', async (request) => {
  return renderPage("Welcome!")
}, { success: { contentType: 'text/html'}});

api.get('/v1/{timestamp}/publication', async (request) => {
  let publications = []

  const client = new pg.Client()
  await client.connect()
  try {
    let query = "SELECT p.id, p.name, p.timestamp, scan.screenshot FROM scan, \
                 (SELECT publication.id as id, publication.name as name, publication.default_scan_name as scan_name, \
                   MAX(scan.timestamp) as timestamp FROM publication \
                 JOIN scan ON scan.publication_id = publication.id \
                 AND scan.name = publication.default_scan_name"
    if (request.pathParams.timestamp) {
      query +=  " WHERE EXTRACT(epoch FROM scan.timestamp) < " + parseInt(request.pathParams.timestamp).toString()
    }
    query +=    " GROUP BY publication.id, publication.name, publication.default_scan_name) p \
                 WHERE p.timestamp = scan.timestamp AND scan.name = p.scan_name"

    const res = await client.query(query)
    for (const row of res.rows) {
      publications.push({
        id: row.id, 
        name: row.name,
        timestamp: row.timestamp,
        screenshot: row.screenshot
      })
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }

  return publications
});

api.get('/v1/{timestamp}/publication/{id}/articles', async (request) => {
  let publicationId = parseInt(request.pathParams.id)
  let articles = null
  const count = request.queryString.count || 5

  const client = new pg.Client()
  await client.connect()
  try {
    const res = await client.query("SELECT default_scan_name FROM publication WHERE id = $1", [publicationId])
    const scanName = res.rows[0].default_scan_name
    articles = await getPlacements(count, 0, scanName, request.pathParams.timestamp)
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }

  return articles
});

api.get('/v1/article/{id}', async (request) => {
  let versions = []

  const client = new pg.Client()
  await client.connect()
  try {
    versions = await getVersions(decodeURIComponent(request.pathParams.id), client)
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
  return versions
});

api.get('/v1/now', async (request) => {
  const articles = await getArticles()
  return articles
})

api.get('/v1/snapshot/{names}', async (request) => {
  let output = {}
  const count = parseInt(request.queryString.count || 50)
  const client = new pg.Client()
  await client.connect()
  try {
    const timestamp = request.queryString.timestamp
    const names = request.pathParams.names.split(',')
    for (let name of names) {
      let res
      if (timestamp) {
        res = await client.query('SELECT articles_json as articles, screenshot, timestamp FROM snapshot \
        WHERE scan_name = $1 ORDER BY abs(extract (EPOCH from timestamp) - $2) ASC LIMIT 1', [name, parseInt(timestamp)])   
      } else {
        res = await client.query('SELECT articles_json as articles, screenshot, timestamp FROM snapshot \
        WHERE scan_name = $1 ORDER BY timestamp DESC LIMIT 1', [name])
      }
      if (res.rows.length && res.rows[0].articles) {
        output[name] = {
          screenshot: res.rows[0].screenshot,
          timestamp: res.rows[0].timestamp
        }
        const articles = []
        for (const url in res.rows[0].articles) {
          const article = res.rows[0].articles[url]
          article.url = url
          articles.push(article)
        }
        articles.sort((a,b) => {
          return b.rank - a.rank
        })
        output[name].articles = articles
      }
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
  return output
});

module.exports = api