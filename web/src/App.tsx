import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Home } from './pages/Home'
import { ProductPage } from './pages/ProductPage'
import { SignIn } from './pages/SignIn'

function Gate() {
  const { session, loading } = useAuth()
  if (loading) return <main><p className="muted">Loading…</p></main>
  if (!session) return <SignIn />
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/product/:id" element={<ProductPage />} />
      <Route path="*" element={<Home />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  )
}
