import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'
import {schemaTypes} from './schemaTypes/index.js'

const projectId = process.env.SANITY_STUDIO_PROJECT_ID || ''
const dataset = process.env.SANITY_STUDIO_DATASET || 'production'

export default defineConfig({
  name: 'studio-locater',
  title: 'Studio Locater CMS',
  projectId: projectId || 'placeholder',
  dataset,
  plugins: [structureTool()],
  schema: {types: schemaTypes}
})
