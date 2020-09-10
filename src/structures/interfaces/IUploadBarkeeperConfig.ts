import { IEnabledFields } from './IEnabledFields'

export interface IUploadBarkeeperConfig {
  busboy?: busboy.BusboyConfig,
  enabledFields?: IEnabledFields[],
  enabledAdditionalFields?: boolean,
  limits: { files: number },
  mimetypes: string[],
  bodyBase64FieldName?: string,
  bodyUrlFieldName?: string
}
