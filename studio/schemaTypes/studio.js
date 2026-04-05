import {defineField, defineType} from 'sanity'

export const studio = defineType({
  name: 'studio',
  title: 'Studio',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      validation: Rule => Rule.required()
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: {source: 'name', maxLength: 96}
    }),
    defineField({
      name: 'address',
      title: 'Address',
      type: 'address',
      validation: Rule => Rule.required()
    }),
    defineField({
      name: 'location',
      title: 'Map location',
      type: 'geopoint',
      description:
        'Optional. If you set a pin, we use it. If you leave it empty, the app plots the studio by geocoding the address when someone searches nearby (slower, depends on geocoding).'
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{type: 'string'}],
      options: {layout: 'tags'},
      initialValue: ['Yoga']
    }),
    defineField({
      name: 'rating',
      title: 'Rating',
      type: 'number',
      validation: Rule => Rule.min(0).max(5).precision(1),
      initialValue: 4.5
    }),
    defineField({
      name: 'reviews',
      title: 'Review count',
      type: 'number',
      initialValue: 50
    }),
    defineField({
      name: 'priceTier',
      title: 'Price tier',
      type: 'number',
      description: '1 = $, 2 = $$, 3 = $$$',
      validation: Rule => Rule.min(1).max(3).integer(),
      initialValue: 2
    }),
    defineField({
      name: 'featured',
      title: 'Featured',
      type: 'boolean',
      initialValue: false
    }),
    defineField({
      name: 'badge',
      title: 'Badge text',
      type: 'string',
      description: 'Shown on the card when Featured is on (e.g. Editor pick)',
      hidden: ({parent}) => !parent?.featured
    })
  ],
  preview: {
    select: {
      title: 'name',
      line1: 'address.streetLine1',
      city: 'address.city',
      region: 'address.region'
    },
    prepare({title, line1, city, region}) {
      const sub = [line1, city, region].filter(Boolean).join(' · ')
      return {title, subtitle: sub || 'No address'}
    }
  }
})
