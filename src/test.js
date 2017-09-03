import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

//trigger('check', {})

const api = require('./api')
const context = {
  done: (err, result) => {
    console.log(result)
  },
  fail: (err) => {
    console.error(err)
  }
}
api.proxyRouter({
  requestContext: {
    resourcePath: '/v1/publication/1/articles',
    httpMethod: 'GET'
  },
}, context)
