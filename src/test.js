import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

trigger('scan', {
    "url": "https://nytimes.com",
    "linkRegex": ".*nytimes.com/20[0-9][0-9]/.*"
})
.then(() => {
  console.log("Finished!")
  process.exit()
})
.catch(err => console.log(err))


