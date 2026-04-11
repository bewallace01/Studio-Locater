const {defineCliConfig} = require('sanity/cli')

const projectId = process.env.SANITY_STUDIO_PROJECT_ID || 't0z5ndwm'
const dataset = process.env.SANITY_STUDIO_DATASET || 'production'

module.exports = defineCliConfig({
  api: {projectId, dataset},
  /** Hosted Studio URL: https://<studioHost>.sanity.studio — change if already taken. */
  studioHost: 'studio-locater',
})
