export async function compressPaperImage(file: File, fallbackName: string) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose a photo or image of the complete paper record.')
  }
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot prepare the paper image.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    for (const quality of [0.78, 0.66, 0.54]) {
      const blob = await canvasBlob(canvas, quality)
      if (blob.size <= 900_000) {
        const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 100) || fallbackName
        return { bytes: await blob.arrayBuffer(), fileName: `${baseName}.jpg` }
      }
    }
    throw new Error('The paper photo is still too large. Move closer and photograph only the page.')
  } finally {
    bitmap.close()
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('The browser could not compress this image.'))
    }, 'image/jpeg', quality)
  })
}
