import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

//trigger('check', {})

const api = require('./api')
const context = {
  done: (err, result) => {
    console.log("Request finished: " + result)
  },
  fail: (err) => {
    console.error(err)
  }
}
api.proxyRouter({
  pathParameters: {
    id: 1
  },
  requestContext: {
    resourcePath: '/v1/publication/{id}/articles',
    httpMethod: 'GET'
  },
}, context)
