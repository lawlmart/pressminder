import ApiBuilder from 'claudia-api-builder'
import  AWSXRay from 'aws-xray-sdk'
import moment from 'moment'
import { getVersions } from './tasks'
if (process.env.NODE_ENV == 'production') {
  Client = AWSXRay.capturePostgres(require('pg')).Client
} else {
  Client = require('pg').Client
}
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

    const res = await client.query("SELECT version.url, version.title, p.started, \
                                    version.text, version.timestamp, version.authors \
                                    FROM article, version, \
                                    (SELECT placement.url, MAX(placement.started) as started FROM placement WHERE placement.ended IS NULL GROUP BY placement.url) p \
                                    WHERE p.url = article.url AND version.url = p.url AND p.url IS NOT NULL \
                                    ORDER BY p.started DESC, version.timestamp ASC LIMIT $1 OFFSET $2", [count, offset])
    
    let lastId = null  

    for (const row of res.rows) {
      if (row.url != lastId) {
        articles.push({
          url: row.url,
          since:  row.started,
          versions: [{
            text: row.text,
            timestamp: row.timestamp,
            authors: row.authors,
            title: row.title,
          }]
        })
      } else {
        articles.slice(-1)[0].versions.push({
          test: row.text,
          timestamp: row.timestamp,
          authors: row.authors,
          title: row.title
        })
      }
      lastId = row.url
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
  return renderPage(articles.map(a => "<div><a href='" + a.url + "'>" +
    (a.versions.length ? a.versions.slice(-1)[0].title : 'loading ...') + "</a> " + 
    "<span>" + (a.since ? moment(a.since).fromNow() : '') + "</span>" +
    a.versions.map((v, idx) => "<a href='/article/" + encodeURIComponent(a.url) + "/version/" + idx.toString() + "'>" + moment(v.timestamp).fromNow() + "</a>").join("") +
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

api.intercept(function (request) {
  console.log(request)
  return request
});

module.exports = api