import { IEnabledFields } from './IEnabledFields'

export interface IUploadBarkeeperConfig {
  busboy: busboy.BusboyConfig,
  enabledFields: IEnabledFields[]
}
