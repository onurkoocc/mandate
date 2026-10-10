public final class Pager {
  public static int pageCount(int total, int perPage) {
    return (total + perPage - 1) / perPage;
  }
}
