import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

//trigger('check', {"url": "http://www.washingtonpost.com",   "linkRegex": ".*washingtonpost.com/?.*/20[0-9][0-9]/.*" })
trigger('check', {"url": "http://www.nytimes.com",   "linkRegex": ".*nytimes.com/?.*/20[0-9][0-9]/.*" })
