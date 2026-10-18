/**
 * Calls to the Supabase edge functions (identify, drive). The phone never holds
 * Google or Anthropic credentials; the functions do the work and answer in JSON.
 */
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'

export async function callFunction<T>(name: 'identify' | 'drive', body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let message = error.message
    if (error instanceof FunctionsHttpError) {
      try {
        const j = await error.context.json()
        if (j?.error) message = j.error
      } catch {
        /* not JSON: keep the generic message */
      }
    } else if (/Failed to send|fetch/i.test(message)) {
      message = `The ${name} service is not reachable yet. It may not be deployed.`
    }
    throw new Error(message)
  }
  return data as T
}

/** What identify found for a barcode, a photo of the box or a pasted link. */
export interface Identification {
  via: 'barcode' | 'photo' | 'link' | 'name'
  name: string | null          // short product name, also the Drive folder name
  brand: string | null
  variant: string | null
  upc: string | null
  asin: string | null
  title: string | null         // long listing title, when there is one
  image_url: string | null
  url: string | null
  platform: 'amazon' | 'tiktok' | null
  tiktok_product_id: string | null
  confidence: 'high' | 'medium' | 'low' | null
  note: string | null          // anything worth showing on the Confirm screen
}

export interface DriveStatus { connected: boolean; email: string | null; products_folder_id: string | null }

export const driveStatus = () => callFunction<DriveStatus>('drive', { action: 'status' })

/** Creates (or finds) Content Library/Products/<name> with raw and finished, and saves its id on the product. */
export const makeDriveFolder = (productId: string) =>
  callFunction<{ folder_id: string; folder_name: string; created: boolean }>('drive', { action: 'create_folder', product_id: productId })

/** Uploads a photo into the product's Drive folder and records it as a media row. */
export const uploadPhoto = (productId: string, photo: { base64: string; width: number; height: number }, kind: 'intake_photo' = 'intake_photo') =>
  callFunction<{ media_id: string; drive_file_id: string }>('drive', {
    action: 'upload', product_id: productId, kind, mime: 'image/jpeg',
    filename: `intake ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.jpg`,
    data: photo.base64, width: photo.width, height: photo.height,
  })

export interface SyncResult { added: number; raw: number; finished: number; status_changed: boolean; note?: string }

/** Records clips found in the product's raw/ and finished/ folders that the app doesn't know yet. */
export const syncFromDrive = (productId: string) => callFunction<SyncResult>('drive', { action: 'sync', product_id: productId })

export interface FolderListing { folder: { id: string; name: string; parent: string | null }; folders: { id: string; name: string }[] }

/** Subfolders of a Drive folder ('root' = My Drive), for picking the Products folder by hand. */
export const listFolders = (parent = 'root') => callFunction<FolderListing>('drive', { action: 'list_folders', parent })

export const setProductsFolder = (folderId: string) =>
  callFunction<{ products_folder_id: string; name: string }>('drive', { action: 'set_products_folder', folder_id: folderId })
