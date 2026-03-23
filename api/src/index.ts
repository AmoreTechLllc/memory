import { Elysia } from 'elysia'
import { drizzle } from 'drizzle-orm/node-postgres'
import { _createPost, _selectUsers } from './types'
import { postsPlugin, authPlugin, setupPlugin, atBridgePlugin } from './routes'
import atBridgeWebhookPlugin from './routes/atBridgeWebhook'

export const db = drizzle({ connection: process.env.DB_URL || '', casing: 'snake_case' })

export const app = new Elysia()
  .use(setupPlugin)
  .macro({
    isSignedIn: enabled => {
      if (!enabled) return

      return {
        async beforeHandle({ headers: { auth }, jwt, error, user }) {
          const authValue = await jwt.verify(auth)
          if (!authValue) {
            return error(401, 'You must be signed in to do that')
          } else {
            user.loadUser(JSON.parse(authValue.user as string))
          }
        }
      }
    }
  })
  .use(authPlugin)
  .use(postsPlugin)
  .use(atBridgePlugin)
  .use(atBridgeWebhookPlugin)
  .listen(process.env.API_PORT || 8796)

console.info(`Listening on port ${process.env.API_PORT}`)

export type App = typeof app
