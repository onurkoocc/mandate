class PagerTest {
  @Test void countsAPartialLastPage() { assertEquals(3, Pager.pageCount(11, 5)); }
}
