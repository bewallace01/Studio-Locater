import {useEffect, useRef} from 'react'
import {SlugInput, set, useFormValue} from 'sanity'
import {slugifyStudio} from '../lib/slugifyStudio.js'

/**
 * Wraps the default slug field: when slug is empty and Name has text,
 * fills the slug automatically (stable once set — does not overwrite).
 */
export function StudioSlugInput(props) {
  const name = useFormValue(['name'])
  const slugCurrent = props.value?.current
  const onChange = props.onChange
  const skipNext = useRef(false)

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false
      return
    }
    const n = name != null && String(name).trim() ? String(name).trim() : ''
    if (!n) return
    if (slugCurrent != null && String(slugCurrent).trim()) return

    const next = slugifyStudio(n)
    if (!next) return

    onChange(
      set({
        _type: 'slug',
        current: next
      })
    )
  }, [name, slugCurrent, onChange])

  return <SlugInput {...props} />
}
