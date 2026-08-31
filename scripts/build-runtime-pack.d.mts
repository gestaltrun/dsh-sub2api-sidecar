export interface LocalSub2apiSource {
  readonly url: null
  readonly version: string
  readonly sourceRef: string
  readonly archiveSha256: null
  readonly binarySha256: string
}

export function installLocalSub2api(
  binaryPath: string,
  sourceRef: string,
  version: string,
  packBin: string,
): Promise<LocalSub2apiSource>
