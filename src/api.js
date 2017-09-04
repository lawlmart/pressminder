import ApiBuilder from 'claudia-api-builder'
import  AWSXRay from 'aws-xray-sdk'
import moment from 'moment'
import { getVersions } from './tasks'
const Promise = require("bluebird")
const Client = require('pg').Client
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

const getArticles = async function(count, offset, name, platform, timestamp) {
  const articles = []  

  const client = new Client()
  await client.connect()
  try {
    let vars = [timestamp || Math.round(Date.now() / 1000), count, offset]
    let query = "SELECT MIN(placement.started) as first_seen, scan.platform, placement.scan_name, \
    placement.top, placement.url, version.title, version.timestamp, version.keywords, \
    version.generated_keywords FROM placement, version, scan, (SELECT url, max(timestamp) as timestamp \
    FROM version GROUP BY url) v, \
    (SELECT placement.url, placement.scan_name, min(placement.top) as top FROM placement \
    JOIN scan ON placement.scan_id = scan.id WHERE placement.ended IS NULL AND \
    EXTRACT (epoch FROM scan.timestamp) < $1 GROUP BY placement.url, placement.scan_name) t \
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
    query += " GROUP BY placement.scan_name, scan.platform, placement.top, placement.url, version.title, version.timestamp, \
    version.keywords, version.generated_keywords ORDER BY top ASC LIMIT $2 OFFSET $3"
    const res = await client.query(query, vars)
    for (const row of res.rows) {
      articles.push({
        url: row.url,
        since: row.first_seen,
        name: row.scan_name,
        title: row.title
      })
    }
  }
  catch (err) {
    console.log("Error: " + err)
  } finally {
    await client.end()
  }
  return articles
}

api.get('/', async (request) => {
  const count = request.queryString.count || 50
  const page = request.queryString.page || 1
  const name = request.queryString.name
  const platform = request.queryString.platform
  const articles = await getArticles(count, (page-1) * count, name, platform)
  return renderPage(articles.map(a => "<div><a href='" + a.url + "'>" + a.title + "</a> " + 
    " <span>" + (a.since ? moment(a.since).fromNow() : '') + "</span> " +
    "</div>").join(""))
}, { success: { contentType: 'text/html'}});

api.get('/article/{id}', async (request) => {
  let versions = []

  const client = new Client()
  await client.connect()
  try {
    versions = await getVersions(decodeURIComponent(request.pathParams.id), client)
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
  const articles = []  
  return renderPage("<pre style='white-space: pre-wrap;'>" + versions.slice(-1)[0].text + "</pre>")
}, { success: { contentType: 'text/html'}});

api.get('/article/{id}/version/{version}', async (request) => {
  let versions = []

  const client = new Client()
  await client.connect()
  try {
    versions = await getVersions(decodeURIComponent(request.pathParams.id), client)
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
  return renderPage("<pre style='white-space: pre-wrap;'>" + versions[request.pathParams.version].text + "</pre>")
}, { success: { contentType: 'text/html'}});

api.get('/v1/publication', async (request) => {
  let publications = []

  const client = new Client()
  await client.connect()
  try {
    let query = "SELECT p.id, p.name, p.timestamp, scan.screenshot FROM scan, \
                 (SELECT publication.id as id, publication.name as name, publication.default_scan_name as scan_name, \
                   MAX(scan.timestamp) as timestamp FROM publication \
                 JOIN scan ON scan.publication_id = publication.id \
                 AND scan.name = publication.default_scan_name"
    if (request.queryString.timestamp) {
      query +=  " WHERE EXTRACT(epoch FROM scan.timestamp) < " + parseInt(request.queryString.timestamp).toString()
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

api.get('/v1/publication/{id}/articles', async (request) => {
  let publicationId = parseInt(request.pathParams.id)
  let articles = null
  const count = request.queryString.count || 5

  const client = new Client()
  await client.connect()
  try {
    const res = await client.query("SELECT default_scan_name FROM publication WHERE id = $1", [publicationId])
    const scanName = res.rows[0].default_scan_name
    articles = await getArticles(count, 0, scanName, null, request.queryString.timestamp)
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

  const client = new Client()
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

module.exports = api