import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

//trigger('check', {})

const api = require('./api')
const context = {
  done: () => {
    console.log("done")
  },
  fail: () => {
    console.log("fail")
  }
}
api.proxyRouter({
  requestContext: {
    resourcePath: '/',
    httpMethod: 'GET'
  },
}, context)
