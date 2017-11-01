import { trigger } from './events'
import  AWSXRay from 'aws-xray-sdk'
AWSXRay.enableManualMode()

console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));


const segment = new AWSXRay.Segment('handler');
trigger('snapshot', {}, segment).then(() => {
  segment.close()
})

/*
const api = require('./api')
const context = {
  done: (err, result) => {
    console.log("Request finished: " + JSON.stringify(result))
  },
  fail: (err) => {
    console.error(err)
  }
}
api.proxyRouter({
  pathParameters: {
    names: 'nyt,bbc'
  },
  requestContext: {
    resourcePath: '/v1/snapshot/{names}',
    httpMethod: 'GET'
  },
}, context)
*/


