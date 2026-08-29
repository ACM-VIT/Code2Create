/** The screens the dev gallery offers, in flow order. */
export const GALLERY_SCREENS = [
  { id: 'f0a', label: 'Entry' },
  { id: 'f0b', label: 'Details' },
  { id: 'f0c', label: 'Team start' },
  { id: 'f2', label: 'Idea' },
  { id: 'f3', label: 'Follow-up' },
  { id: 'f4', label: 'Follow-up · empty' },
  { id: 'f5', label: 'Review' },
  { id: 'f6', label: 'Confirm' },
  { id: 'f7', label: 'Submitted' },
  { id: 'loading', label: 'Loading' },
  { id: 'notice', label: 'Access notice' },
] as const

export type GalleryScreenId = (typeof GALLERY_SCREENS)[number]['id']
