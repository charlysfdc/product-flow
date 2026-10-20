import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Home } from './pages/Home'
import { ProductPage } from './pages/ProductPage'
import { SignIn } from './pages/SignIn'
import { DealPage } from './pages/DealPage'
import { Settings } from './pages/Settings'
import { WaitingDeals } from './pages/WaitingDeals'
import { AddProduct } from './pages/AddProduct'
import { Review } from './pages/Review'
import { Script } from './pages/Script'
import { Publish } from './pages/Publish'
import { ProductList, Products } from './pages/Products'
import { StatDetail, Stats } from './pages/Stats'
import { FixList, HiddenPage, Housekeeping } from './pages/Housekeeping'
import { UploadBar } from './components/Clips'

function Gate() {
  const { session, loading, notice, clearNotice } = useAuth()
  if (loading) return <main><p className="muted">Loading…</p></main>
  if (!session) return <SignIn />
  return (
    <>
    {notice && <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 14px' }}><div className="notice"><span>{notice}</span><button onClick={clearNotice}>OK</button></div></div>}
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/product/:id" element={<ProductPage />} />
      <Route path="/deal/:id" element={<DealPage />} />
      <Route path="/deals/waiting" element={<WaitingDeals />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/add" element={<AddProduct />} />
      <Route path="/review/:jobId" element={<Review />} />
      <Route path="/script/:jobId" element={<Script />} />
      <Route path="/publish/:id" element={<Publish />} />
      <Route path="/products" element={<Products />} />
      <Route path="/products/:list" element={<ProductList />} />
      <Route path="/stats" element={<Stats />} />
      <Route path="/stats/:kind" element={<StatDetail />} />
      <Route path="/housekeeping" element={<Housekeeping />} />
      <Route path="/housekeeping/fix/:kind" element={<FixList />} />
      <Route path="/housekeeping/hidden" element={<HiddenPage />} />
      <Route path="*" element={<Home />} />
    </Routes>
    <UploadBar />
    </>
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
