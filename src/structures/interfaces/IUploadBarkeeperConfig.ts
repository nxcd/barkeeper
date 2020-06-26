import { IEnabledFields } from './IEnabledFields'

export interface IUploadBarkeeperConfig {
  busboy?: busboy.BusboyConfig,
  enabledFields?: IEnabledFields[],
  enabledAdditionalFields?: boolean,
  limits: { files: number },
  mimetypes: string[],
  bodyFieldName?: string
}
