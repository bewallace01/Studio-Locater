import {defineField, defineType} from 'sanity'

export const address = defineType({
  name: 'address',
  title: 'Address',
  type: 'object',
  fields: [
    defineField({
      name: 'streetLine1',
      title: 'Street line 1',
      type: 'string',
      description: 'Building number and street',
      validation: Rule => Rule.required()
    }),
    defineField({
      name: 'streetLine2',
      title: 'Street line 2',
      type: 'string',
      description: 'Suite, unit, floor (optional)'
    }),
    defineField({
      name: 'city',
      title: 'City',
      type: 'string',
      validation: Rule => Rule.required()
    }),
    defineField({
      name: 'region',
      title: 'State / province / region',
      type: 'string',
      description: 'e.g. CA, NY, ON'
    }),
    defineField({
      name: 'postalCode',
      title: 'ZIP / postal code',
      type: 'string'
    }),
    defineField({
      name: 'country',
      title: 'Country',
      type: 'string',
      description: 'ISO country code (e.g. US) or full name',
      initialValue: 'US'
    })
  ],
  preview: {
    select: {
      line1: 'streetLine1',
      line2: 'streetLine2',
      city: 'city',
      region: 'region',
      postalCode: 'postalCode',
      country: 'country'
    },
    prepare({line1, line2, city, region, postalCode, country}) {
      const street = [line1, line2].filter(Boolean).join(', ')
      const locality = [city, region].filter(Boolean).join(', ')
      const tail = [postalCode, country].filter(Boolean).join(' ')
      const parts = [street, locality, tail].filter(Boolean)
      return {title: parts.join(' · ') || 'Address'}
    }
  }
})
