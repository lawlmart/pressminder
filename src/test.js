import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

trigger('check')

trigger('scan', {"url": "http://www.latimes.com",   "linkRegex": "/.*/.*story.*html.*" })
.then(() => {
  console.log("Finished scanning")
})
.catch(err => console.log(err))

trigger('scan', {"url": "https://www.washingtonpost.com",   "linkRegex": ".*washingtonpost.com/.*/20[0-9][0-9]/.*" })
.then(() => {
  console.log("Finished scanning")
})
.catch(err => console.log(err))