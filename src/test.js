import { trigger } from './events'
console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

trigger('check', {})
