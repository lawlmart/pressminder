import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

trigger('check')

trigger('scan', {
    "url": "https://nytimes.com",
    "linkRegex": ".*nytimes.com/20[0-9][0-9]/.*"
})
.then(() => {
  console.log("Finished scanning nytimes")
})
.catch(err => console.log(err))

trigger('scan', {
  "url": "https://washingtonpost.com",
  "linkRegex": ".*washingtonpost.com/(news|politics|opinions|blogs|sports|local|national|world|business|tech|lifestyle|entertainment|outlook)/.+"
})
.then(() => {
console.log("Finished scanning wpo")
})
.catch(err => console.log(err))


