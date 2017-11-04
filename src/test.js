import { trigger } from './events'
import  AWSXRay from 'aws-xray-sdk'

console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));


trigger('url', {url: 'https://www.washingtonpost.com/world/stricken-us-destroyer-arrives-in-singapore-after-collision-10-sailors-missing/2017/08/21/8ad075b0-8646-11e7-a50f-e0d4e6ec070a_story.html?utm_term=.a322f3f3b33e'}).then(() => {

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


