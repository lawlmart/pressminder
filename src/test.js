import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

trigger('check')

trigger('scan', {"url": "http://www.latimes.com",   "linkRegex": "/.*/.*story.*html.*" })
.then(() => {
  console.log("Finished scanning")
})
.catch(err => console.log(err))

