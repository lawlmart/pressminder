import { trigger } from './events'
import  AWSXRay from 'aws-xray-sdk'
AWSXRay.enableManualMode()

console.log("Running tests")

process.on('unhandledRejection', r => console.log(r));

const segment = new AWSXRay.Segment('handler');
trigger('snapshot', {}).then(() => {
  segment.close()
})


