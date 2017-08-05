const request = require('request-promise')
const cheerio = require('cheerio')
const fs = require('fs')
const unfluff = require('unfluff')
const S3 = require('aws-sdk/clients/s3');
const Kinesis = require('aws-sdk/clients/kinesis');
const AWSXRay = require('aws-xray-sdk');
const { Client, Pool } = require('pg')
var kinesis = require('@heroku/kinesis')

const BUCKET = 'pressminder'

const sendToStream = (stream, data) => {
  const record = {
    Data: new Buffer(JSON.stringify(data)).toString('base64'),
    PartitionKey: "CONSTANT"
  }
  var params = {
    Records: [records],
    StreamName: stream
  };
  kinesis.request('PutRecords', params, { logger: { log: function (m) { } } }, function (err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    }
  });
}

const saveArticles = (articles) => {
  return new Promise((resolve, reject) => {
    const promises = []
    const pool = new Pool()
    pool.connect()
    .then(db => {
      for (let data of articles) {
        db.query('INSERT INTO article (url, title, author, text) \
                  VALUES ($1, $2, $3, $4) \
                  ON CONFLICT (url) DO UPDATE SET last_checked=now()', 
                  [data.canonicalLink, data.title, data.author, data.text],
        (err, res) => {
          if (err) {
            console.log(err)
          }
          promises.push(new Promise((resolve, reject) => err ? reject() : resolve()))
        })
      }
      pool.end()
    })
    Promise.all(promises)
    .then(resolve)
    .catch(reject)
  })
}

const getArticle = (event) => {
  console.log("Processing article: " + JSON.stringify(event))
  return new Promise((resolve, reject) => {
    request(event.url)
    .then((htmlString) => {
      console.log("Downloaded article " + event.url + ", unfluffing")
      resolve(unfluff(htmlString))
    })
    .catch((err) => {
      reject(err)
    });
  })
}

const getUrls = (event) => {
  console.log("Processing urls: " + JSON.stringify(event))
  return new Promise((resolve, reject) => {
    request(event.url)
    .then((htmlString) => {
      const $ = cheerio.load(htmlString)
      const foundUrls = []
      $('a').each((i, elem) => {
        const url = $(elem).attr('href');
        if (url && url.match(new RegExp(event.linkRegex, 'i'))) {
          foundUrls.push(url)
        }
      });
      resolve(foundUrls)
    })
    .catch((err) => {
      reject(err)
    });
  })
}

const pushRecord = (key, message) => {
  const s3 = new S3()
  const params = {
    Bucket: BUCKET, 
    Key: key,
    Body: message
  }
  console.log("Pushing object " + key + ": " + JSON.stringify(params))
  return s3.putObject(params).promise()
}

const getTextFileFromS3 = (bucket, key) => {
  const s3 = new S3()
  const params = {
    Bucket: bucket, 
    Key: key
  }
  console.log("Found s3 params " + JSON.stringify(params))
  return new Promise((resolve, reject) => {
    s3.getObject(params).promise()
    .then(data => {
      const string = data.Body.toString('ascii')
      console.log("Got s3 result: " + string)
      resolve(JSON.parse(string))
    })
    .catch(err => reject(err))
  })
}

// converts an event into an array of data payloads depending on where it's from
const handleEvent = function (event) {
  return new Promise((resolve, reject) => {
    if ('Records' in event) {
      const promises = []
      for (let record of event['Records']) {
        if ('s3' in record) {
          promises.push(getTextFileFromS3(BUCKET, decodeURIComponent(record['s3']['object']['key'])))
        } else if ('kinesis' in record) {
          console.log("Found kinesis payload " + JSON.stringify(record['kinesis']))
          const string = Buffer.from(record['kinesis']['data'], 'base64').toString("ascii")
          console.log("Decoded kinesiss params " + string)
          const data = JSON.parse(string)
          data.source = 'kinesis'
          promises.push(new Promise(resolve => resolve(data)))
        } else {
          console.log("Found unrecognized record type: " + JSON.stringify(record))
        }
      }
      Promise.all(promises)
      .then(data => {
        console.log("Finished processing record results: " + JSON.stringify(data))
        resolve(data)
      })
      .catch(err => {
        console.log("S3 error: " + err.toString())
        reject(err)
      })
    } else if ('url' in event) {
      resolve([event])
    } else {
      reject(new Error("UNRECOGNIZED EVENT TYPE: " + JSON.stringify(event)))
    }
  }) 
}

const handler = function(event, context) {
  console.log("Processing event: " + JSON.stringify(event))
  const promises = []

  handleEvent(event)
  .then(records => {
    const articlesToSave = []
    for (let record of records) {
      if (record.type == 'article') {
        if (record.source == 'kinesis') {
          console.log("Got article from kinesis " + JSON.stringify(data))
          // if it's from kinesis, then we're supposed to save it to db
          articlesToSave.push(record)
        } else {
          getArticle(record)
          .then(data => {
            console.log("Got article: " + JSON.stringify(data))
            promises.push(sendToStream("articles", data))
          })
          .catch(err => {
            console.log(err)
          })
        }
      } else {
        getUrls(record)
        .then(urls => {
          
          for (url of urls) {
            console.log("Found article: " + url)
            
            const name = (new Date().getTime().toString()) + "-" + encodeURIComponent(url).substring(0, 100)
            promises.push(pushRecord(name, JSON.stringify({
              url: url,
              type: 'article'
            })))
          }
          
        })
        .catch(err => {
          console.log(err)
        })
      }
    }
    if (articlesToSave.length) {
      promises.push(saveArticles(articlesToSave))
    }

    Promise.all(promises)
    .then(data => context.succeed(data))
    .catch(err => context.fail(err))
  })
  .catch(err => {
    console.log("Handle event failed: " + err.toString())
    context.fail(err)
  })
}

exports.handler = handler