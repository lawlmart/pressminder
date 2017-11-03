import { trigger } from './events'
import  AWSXRay from 'aws-xray-sdk'

console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));


trigger('snapshot', {}).then(() => {

})



