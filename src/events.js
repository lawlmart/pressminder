import kinesis from '@heroku/kinesis'
import * as tasks from './tasks'
import  AWSXRay from 'aws-xray-sdk'

const sendToStream = (stream, type, payload) => {
  return new Promise((resolve, reject) => {
    const base64data = new Buffer(
      JSON.stringify({
        type,
        payload
      })
    ).toString('base64')
    const params = {
      Records: [{
        Data: base64data,
        PartitionKey: Math.random().toString()
      }],
      StreamName: stream
    };

    kinesis.request('PutRecords', params, { logger: { log: function (m) { } } }, function (err, data) {
      if (err) {
        console.log(err, err.stack); // an error occurred
        reject()
        return
      }
      resolve()
    });
  })
}

export function parseEvents(event) {
  const events = {}

  function addEvent(name, payload) {
    payload = payload || {}
    if (name in events) {
      events[name].push(payload)
    } else {
      events[name] = [payload]
    }
  }
  if ('Records' in event) {
    const promises = []
    for (let record of event['Records']) {
      if ('kinesis' in record) {
        let string = Buffer.from(record['kinesis']['data'], 'base64').toString("utf8")
        let data = JSON.parse(string)
        addEvent(data.type, data.payload)
      } else {
        throw "Found unrecognized record type: " + JSON.stringify(record)
      }
    }
  } else if ('type' in event) {
    addEvent(event.type, event.payload)
  } else {
    throw "No records found in event"
  }
  return events
}


function makeMulti(f) {
  return async (inputs) => {
    const promises = []
    inputs = inputs || [null]
    for (const input of inputs) {
      promises.push(f(input))
    }
    return Promise.all(promises)
  }
}

export async function executeEvents(name, payloads) {
  return new Promise(async (resolve, reject) => {
    let result
    if (name == 'article') {
      result = await tasks.processArticles(payloads)
    } else if (name == 'url') {
      result = await makeMulti(tasks.retrieveArticle)(payloads)
    } else if (name == 'scan_complete') {
      result = await makeMulti(tasks.finishedScan)(payloads)
    } else if (name == 'check') {
      result = await tasks.checkArticles()
    } else if (name == 'snapshots') {
      result = await makeMulti(tasks.snapshots)(payloads)
    } else if (name == 'snapshot') {
      result = await makeMulti(tasks.snapshot)(payloads)
    } else {
      console.log("Unrecognized event: " + name)
    }
    resolve(result)
  })
}

export async function trigger(name, data) {
  if (process.env.NODE_ENV == 'production') {
    console.log("Sending event " + name + " to stream")
    return await sendToStream('pressminder', name, data)
  } else {
    console.log("Executing event " + name + " immediately")
    return await executeEvents(name, [data]);
  }
}