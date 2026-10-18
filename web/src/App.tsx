import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Home } from './pages/Home'
import { ProductPage } from './pages/ProductPage'
import { SignIn } from './pages/SignIn'
import { DealPage } from './pages/DealPage'
import { Settings } from './pages/Settings'
import { WaitingDeals } from './pages/WaitingDeals'

function Gate() {
  const { session, loading } = useAuth()
  if (loading) return <main><p className="muted">Loading…</p></main>
  if (!session) return <SignIn />
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/product/:id" element={<ProductPage />} />
      <Route path="/deal/:id" element={<DealPage />} />
      <Route path="/deals/waiting" element={<WaitingDeals />} />
      <Route path="/settings" element={<Settings />} />
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
