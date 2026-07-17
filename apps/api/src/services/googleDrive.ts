import { google } from 'googleapis';
import { env } from '../config/env.js';
import path from 'path';
import fs from 'fs';

let driveClient: any = null;

function getClient() {
  if (driveClient) return driveClient;

  const keyPath = env.GOOGLE_DRIVE_KEY_PATH;
  if (!keyPath) throw new Error('GOOGLE_DRIVE_KEY_PATH no configurado');

  const keyFile = path.resolve(keyPath);
  if (!fs.existsSync(keyFile)) throw new Error(`Archivo de clave no encontrado: ${keyFile}`);

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink: string;
  parents: string[];
}

// Listar archivos de una carpeta
export async function listFiles(folderId: string, pageSize = 50): Promise<DriveFile[]> {
  const drive = getClient();
  const safeFolderId = folderId.replace(/['"\\]/g, '');
  const res = await drive.files.list({
    q: `'${safeFolderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, parents)',
    pageSize,
    orderBy: 'modifiedTime desc',
  });
  return res.data.files || [];
}

// Listar subcarpetas
export async function listFolders(folderId: string): Promise<DriveFile[]> {
  const drive = getClient();
  const safeFolderId = folderId.replace(/['"\\]/g, '');
  const res = await drive.files.list({
    q: `'${safeFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime, webViewLink)',
    orderBy: 'name',
  });
  return res.data.files || [];
}

// Descargar archivo como Buffer
export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; name: string; mimeType: string }> {
  const drive = getClient();

  // Obtener metadata
  const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size' });
  const name = meta.data.name;
  const mimeType = meta.data.mimeType;

  // Si es Google Doc, exportar como PDF
  if (mimeType?.startsWith('application/vnd.google-apps')) {
    const exportMime = 'application/pdf';
    const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(res.data as ArrayBuffer), name: name + '.pdf', mimeType: exportMime };
  }

  // Archivo normal
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data as ArrayBuffer), name, mimeType };
}

// Buscar archivos por nombre
export async function searchFiles(folderId: string, query: string): Promise<DriveFile[]> {
  const drive = getClient();
  const safeFolderId = folderId.replace(/['"\\]/g, '');
  const escapedQuery = query.replace(/['"\\]/g, '').substring(0, 100);
  const res = await drive.files.list({
    q: `'${safeFolderId}' in parents and name contains '${escapedQuery}' and trashed = false`,
    fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink)',
    pageSize: 20,
    orderBy: 'modifiedTime desc',
  });
  return res.data.files || [];
}
