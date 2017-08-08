import API from 'claudia-api-builder'
import  AWSXRay from 'aws-xray-sdk'

const api = new API()

api.get('/', () => 'hello world!')

module.exports = api