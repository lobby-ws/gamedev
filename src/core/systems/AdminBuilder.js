import { ClientBuilder } from './ClientBuilder'

export class AdminBuilder extends ClientBuilder {
  canBuild() {
    return true
  }
}
