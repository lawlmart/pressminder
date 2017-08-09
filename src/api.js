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

const getArticles = async function() {
  const client = new Client()
  await client.connect()

  const res = await client.query("SELECT article.id, article.url, article.title, placement.started, \
                                  version.text, version.timestamp \
                                  FROM article \
                                  LEFT JOIN placement ON placement.article_id = article.id \
                                  LEFT JOIN version ON version.article_id = article.id \
                                  AND placement.ended IS NULL \
                                  WHERE placement.started IS NOT NULL and placement.ended IS NULL \
                                  ORDER BY placement.started DESC, version.timestamp ASC")
  
  let lastId = null  
  const articles = []  

  for (const row of res.rows) {
    if (row.id != lastId) {
      articles.push({
        id: row.id,
        url: row.url,
        title: row.title,
        since:  row.started,
        versions: [{
          text: row.text,
          timestamp: row.timestamp
        }]
      })
    } else {
      articles.slice(-1)[0].versions.push({
        test: row.text,
        timestamp: row.timestamp
      })
    }
    lastId = row.id
  }

  await client.end()
  return articles
}

api.get('/', async (request) => {
  const articles = await getArticles()
  return renderPage(articles.map(a => "<div><a href='" + a.url + "'>" +
    a.title + "</a> " + 
    "<span>" + (a.since ? moment(a.since).fromNow() : '') + "</span>" +
    a.versions.map((v, idx) => "<a href='/article/" + a.id + "/version/" + idx.toString() + "'>" + moment(v.timestamp).fromNow() + "</a>").join("") +
    "</div>").join(""))
}, { success: { contentType: 'text/html'}});

api.get('/article/{id}', async (request) => {
  const client = new Client()
  await client.connect()
  const versions = await getVersions(request.pathParams.id, client)
  await client.end()
  return renderPage("<pre style='white-space: pre-wrap;'>" + versions.slice(-1)[0].text + "</pre>")
}, { success: { contentType: 'text/html'}});

api.get('/article/{id}/version/{version}', async (request) => {
  const client = new Client()
  await client.connect()
  const versions = await getVersions(request.pathParams.id, client)
  await client.end()
  return renderPage("<pre style='white-space: pre-wrap;'>" + versions[request.pathParams.version].text + "</pre>")
}, { success: { contentType: 'text/html'}});

api.intercept(function (request) {
  console.log(request)
  return request
});

module.exports = api