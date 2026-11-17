import { supabase, isSupabaseConfigured } from '../supabase';

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export function validateMarketImageFile(file: File): string | null {
  if (!file) return 'Nenhum ficheiro selecionado.';
  if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
    return 'Formato de imagem inválido. Utilize JPG, PNG, WEBP ou GIF.';
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    return 'A imagem deve ter no máximo 5 MB.';
  }
  return null;
}

/**
 * Uploads a validated cover image to the Supabase Storage `market-images` bucket
 * and returns its public URL.
 */
export async function uploadMarketImage(file: File): Promise<string> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase não configurado para upload de imagens.');
  }

  const validationError = validateMarketImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const ext = MIME_TO_EXT[file.type] || 'jpg';
  const uniqueId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filePath = `markets/${uniqueId}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('market-images')
    .upload(filePath, file, {
      cacheControl: '3600',
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    const msg = String(uploadError.message || '');
    if (msg.toLowerCase().includes('bucket') || msg.toLowerCase().includes('not found')) {
      throw new Error(
        'Bucket "market-images" não encontrado no Supabase Storage. Crie o bucket público "market-images" ou insira um URL https://.'
      );
    }
    throw new Error(msg || 'Erro ao carregar imagem para o Supabase Storage.');
  }

  const { data: publicUrlData } = supabase.storage
    .from('market-images')
    .getPublicUrl(filePath);

  if (!publicUrlData?.publicUrl) {
    throw new Error('Não foi possível obter o URL público da imagem carregada.');
  }

  return publicUrlData.publicUrl;
}
