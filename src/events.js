import kinesis from '@heroku/kinesis'
import * as tasks from './tasks'

const sendToStream = (stream, data) => {
  return new Promise((resolve, reject) => {
    const params = {
      Records: [{
        Data: new Buffer(JSON.stringify(data)).toString('base64'),
        PartitionKey: "CONSTANT"
      }],
      StreamName: stream
    };

    console.log("Sending params " + JSON.stringify(params) + " to kinesis")
    
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
        console.log("Found kinesis payload " + JSON.stringify(record['kinesis']))
        let string = Buffer.from(record['kinesis']['data'], 'base64').toString("utf8")
        console.log("Decoded kinesis params " + string)
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
    for (const input of inputs) {
      promises.push(f(input))
    }
    return Promise.all(promises)
  }
}

export async function executeEvents(name, payloads) {
  let f
  if (name == 'article') {
    f = tasks.processArticles
  } else if (name == 'url') {
    f = makeMulti(tasks.retrieveArticle)
  } else if (name == 'scan') {
    f = makeMulti(tasks.scanPage)
  } else if (name == 'scan_complete') {
    f = makeMulti(tasks.scanComplete)
  }
  return await f(payloads)
}

export async function trigger(name, data) {
  if (process.env.NODE_ENV == 'production') {
    return await sendToStream('articles', {
      type: name,
      payload: data
    })
  } else {
    return await executeEvents(name, [data]);
  }
}