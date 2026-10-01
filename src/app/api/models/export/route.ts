/**
 * GET /api/models/export?id=<modelRecordId>&format=tfjs|nextool
 *   → streams a REAL downloadable zip (model.json + shard bin + metadata.json,
 *     or the .nextool package layout). Application/octet-stream + attachment.
 */
import { fail } from '@/lib/nexool/api-helpers';
import { exportModel, type ExportFormat } from '@/lib/nexool/training/model-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const format = url.searchParams.get('format') ?? 'tfjs';

  if (!id) return fail('INVALID_PARAMS', 'Query parameter "id" is required', 400);
  if (format !== 'tfjs' && format !== 'nextool') {
    return fail('INVALID_PARAMS', 'format must be "tfjs" or "nextool"', 400);
  }

  try {
    const result = await exportModel(id, format as ExportFormat);
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.fileName}"`,
        'Content-Length': String(result.bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return fail('EXPORT_FAILED', err instanceof Error ? err.message : 'Model export failed', 400);
  }
}
