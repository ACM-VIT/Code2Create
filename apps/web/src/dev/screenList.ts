/** The screens the dev gallery offers, in flow order. */
export const GALLERY_SCREENS = [
  { id: 'f0a', label: 'Entry' },
  { id: 'f0b', label: 'Details' },
  { id: 'f0c', label: 'Team start' },
  { id: 'f1', label: 'Home · in progress' },
  { id: 'f2', label: 'Idea' },
  { id: 'f3', label: 'Follow-up' },
  { id: 'f4', label: 'Follow-up · empty' },
  { id: 'f5', label: 'Review' },
  { id: 'fs', label: 'SGLang note' },
  { id: 'f6', label: 'Confirm' },
  { id: 'f7', label: 'Submitted' },
  { id: 'f7b', label: 'Submission view' },
  { id: 'f8', label: 'Accepted' },
  { id: 'f10', label: 'Team lobby' },
  { id: 'f10b', label: 'Team lobby · manage' },
  { id: 'f12', label: 'More' },
  { id: 'gate', label: 'Cooking' },
  { id: 'loading', label: 'Loading' },
  { id: 'notice', label: 'Access notice' },
] as const

export type GalleryScreenId = (typeof GALLERY_SCREENS)[number]['id']
