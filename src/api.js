import ApiBuilder from 'claudia-api-builder'
import  AWSXRay from 'aws-xray-sdk'
import moment from 'moment'
import { getVersions } from './tasks'
const Promise = require("bluebird")
const redis = Promise.promisifyAll(require("redis"));
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

const getArticles = async function(count, offset) {
  const articles = []  

  const client = new Client()
  await client.connect()
  try {

    const res = await client.query("SELECT MIN(placement.started) as first_seen, placement.page, \
    placement.top, placement.url, version.title, version.timestamp, version.keywords, \
    version.generated_keywords FROM placement, version, (SELECT url, max(timestamp) as timestamp \
    FROM version GROUP BY url) v, \
    (SELECT url, max(top) as top FROM placement WHERE ended IS NULL GROUP BY url) t \
    WHERE t.top = placement.top AND t.url = placement.url AND v.url = placement.url AND \
    version.timestamp = v.timestamp  \
    GROUP BY placement.page, placement.top, placement.url, version.title, version.timestamp, \
    version.keywords, version.generated_keywords ORDER BY top ASC LIMIT $1 OFFSET $2", [limit, offset])
    
    for (const row of res.rows) {
      articles.push({
        url: row.url,
        since: row.first_seen,
        page: row.page,
        title: row.title
      })
    }
  }
  catch (err) {
    console.error(err)
  } finally {
    await client.end()
  }
  return articles
}

api.get('/', async (request) => {
  const count = request.queryString.count || 50
  const page = request.queryString.page || 1
  const articles = await getArticles(count, (page-1) * count)
  return renderPage(articles.map(a => "<div><a href='" + a.url + "'>" + a.title + "</a> " + 
    " <span>" + (a.since ? moment(a.since).fromNow() : '') + "</span> " +
    "</div>").join(""))
}, { success: { contentType: 'text/html'}});

api.get('/logs', async (request) => {
  const name = decodeURIComponent(request.queryString.name)
  const redisClient = redis.createClient({
    host: process.env.REDIS_HOST || 'localhost'
  })
  const logs = await redisClient.lrangeAsync("pressminder:log:" + name, 0, -1)
  await redisClient.quitAsync()
  return renderPage("<h1>" + name + "</h1>" + logs.join("<br/>"))
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

api.intercept(function (request) {
  console.log(request)
  return request
});

module.exports = api