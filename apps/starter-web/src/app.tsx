import { HttpError } from '@kit/api-client'
import {
  type QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { getMe, signIn, signOut } from './api'

const meKey = ['me'] as const

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const login = useMutation({
    mutationFn: () => signIn(email, password),
    onSuccess: async () => {
      await queryClient.cancelQueries()
      queryClient.clear()
      await navigate({ to: '/app' })
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    login.mutate()
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {login.isError && <p role="alert">Sign-in failed. Please try again.</p>}
        <button type="submit" disabled={login.isPending}>
          Sign in
        </button>
      </form>
    </main>
  )
}

function Shell() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useQuery({ queryKey: meKey, queryFn: ({ signal }) => getMe(signal), retry: false })
  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.cancelQueries()
      queryClient.clear()
      await navigate({ to: '/login' })
    },
  })

  if (me.isPending) return <main>Loading session…</main>
  if (me.error instanceof HttpError && me.error.status === 401) return <Navigate to="/login" />
  if (me.isError)
    return (
      <main>
        <p role="alert">Could not load your session.</p>
        <button type="button" onClick={() => me.refetch()}>
          Retry
        </button>
      </main>
    )

  return (
    <main>
      <h1>Starter Web</h1>
      <p>Signed in as {me.data.email ?? me.data.subject}</p>
      {logout.isError && <p role="alert">Sign-out failed. Please try again.</p>}
      <button type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>
        Sign out
      </button>
    </main>
  )
}

const rootRoute = createRootRoute({ component: Outlet })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/app" />,
})
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Login,
})
const appRoute = createRoute({ getParentRoute: () => rootRoute, path: '/app', component: Shell })
const routeTree = rootRoute.addChildren([indexRoute, loginRoute, appRoute])

export function createAppRouter() {
  return createRouter({ routeTree })
}

export function App({
  router,
  queryClient,
}: {
  router: ReturnType<typeof createAppRouter>
  queryClient: QueryClient
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
