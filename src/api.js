import ApiBuilder from 'claudia-api-builder'
import  AWSXRay from 'aws-xray-sdk'
import moment from 'moment'
import { getVersions } from './tasks'

const { Client } = require('pg')

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
  const client = new Client()
  await client.connect()

  const res = await client.query("SELECT version.url, version.title, p.started, \
                                  version.text, version.timestamp, version.authors \
                                  FROM article, version, \
                                  (SELECT placement.url, MAX(placement.started) as started FROM placement WHERE placement.ended IS NULL GROUP BY placement.url) p \
                                  WHERE p.url = article.url AND version.url = p.url AND p.url IS NOT NULL \
                                  ORDER BY p.started DESC, version.timestamp ASC LIMIT $1 OFFSET $2", [count, offset])
  
  let lastId = null  
  const articles = []  

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

  await client.end()
  return articles
}

api.get('/', async (request) => {
  const articles = await getArticles(20, 0)
  return renderPage(articles.map(a => "<div><a href='" + a.url + "'>" +
    (a.versions.length ? a.versions.slice(-1)[0].title : 'loading ...') + "</a> " + 
    "<span>" + (a.since ? moment(a.since).fromNow() : '') + "</span>" +
    a.versions.map((v, idx) => "<a href='/article/" + encodeURIComponent(a.url) + "/version/" + idx.toString() + "'>" + moment(v.timestamp).fromNow() + "</a>").join("") +
    "</div>").join(""))
}, { success: { contentType: 'text/html'}});

api.get('/article/{id}', async (request) => {
  const client = new Client()
  await client.connect()
  const versions = await getVersions(decodeURIComponent(request.pathParams.id), client)
  await client.end()
  return renderPage("<pre style='white-space: pre-wrap;'>" + versions.slice(-1)[0].text + "</pre>")
}, { success: { contentType: 'text/html'}});

api.get('/article/{id}/version/{version}', async (request) => {
  const client = new Client()
  await client.connect()
  const versions = await getVersions(decodeURIComponent(request.pathParams.id), client)
  await client.end()
  return renderPage("<pre style='white-space: pre-wrap;'>" + versions[request.pathParams.version].text + "</pre>")
}, { success: { contentType: 'text/html'}});

api.intercept(function (request) {
  console.log(request)
  return request
});

module.exports = api