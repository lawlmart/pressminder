import { trigger } from './events'
import  AWSXRay from 'aws-xray-sdk'

console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));


trigger('snapshot', {timestamp: 1409733293}).then(() => {

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
    names: 'bbc'
  },
  requestContext: {
    resourcePath: '/v1/snapshot/{names}',
    httpMethod: 'GET'
  },
}, context)
*/


