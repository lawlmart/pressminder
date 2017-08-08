import API from 'claudia-api-builder'
import trigger from 'events'

const api = new API()

api.get('/', () => 'test')

module.exports = api