import { trigger } from './events'
import  AWSXRay from 'aws-xray-sdk'

console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

//trigger('snapshot')
trigger('url', {url: 'https://www.nytimes.com/2017/11/06/opinion/mass-shooting-texas-sutherland.html'}).then(() => {

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


