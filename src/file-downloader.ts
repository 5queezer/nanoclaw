import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';

import { logger } from './logger.js';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Download a file from a URL and save it to disk.
 * Returns the local path if successful, or null on failure.
 */
export async function downloadFile(
  url: string,
  destPath: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https://') ? https : http;

    const req = protocol.get(url, (res) => {
      // Follow redirects (up to 1 level)
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        req.destroy();
        downloadFile(res.headers.location, destPath).then(resolve);
        return;
      }

      if (res.statusCode !== 200) {
        logger.warn(
          { url, statusCode: res.statusCode },
          'File download failed with non-200 status',
        );
        resolve(null);
        return;
      }

      // Check Content-Length header if available before writing
      const contentLength = res.headers['content-length'];
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        logger.warn(
          { url, size: contentLength },
          'File too large to download (>20MB), skipping',
        );
        res.destroy();
        resolve(null);
        return;
      }

      const dir = path.dirname(destPath);
      fs.mkdirSync(dir, { recursive: true });

      const fileStream = fs.createWriteStream(destPath);
      let bytesReceived = 0;
      let oversized = false;

      res.on('data', (chunk: Buffer) => {
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_FILE_SIZE && !oversized) {
          oversized = true;
          logger.warn(
            { url, bytesReceived },
            'File exceeded 20MB limit during download, aborting',
          );
          res.destroy();
          fileStream.destroy();
          // Clean up partial file
          try {
            fs.unlinkSync(destPath);
          } catch {
            // ignore cleanup errors
          }
          resolve(null);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        if (!oversized) {
          fileStream.close();
          resolve(destPath);
        }
      });

      fileStream.on('error', (err) => {
        logger.warn({ url, err }, 'File write error during download');
        try {
          fs.unlinkSync(destPath);
        } catch {
          // ignore cleanup errors
        }
        resolve(null);
      });
    });

    req.on('error', (err) => {
      logger.warn({ url, err }, 'File download request error');
      resolve(null);
    });

    req.setTimeout(30000, () => {
      logger.warn({ url }, 'File download timed out after 30s');
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Build the Telegram file download URL given a bot token and file_path
 * (as returned by the Telegram getFile API).
 */
export function getTelegramFileUrl(botToken: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

/**
 * Determine a reasonable file extension from a Telegram file_path or MIME type.
 */
export function getFileExtension(filePath: string, mimeType?: string): string {
  // Try to get extension from the Telegram-provided file path first
  const extFromPath = path.extname(filePath).toLowerCase();
  if (extFromPath && extFromPath.length > 1) {
    return extFromPath.slice(1); // strip leading dot
  }

  // Fall back to MIME type mapping
  if (mimeType) {
    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/mpeg': 'mpeg',
      'video/webm': 'webm',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'application/pdf': 'pdf',
    };
    const mapped = mimeMap[mimeType.toLowerCase()];
    if (mapped) return mapped;
  }

  return 'bin';
}
